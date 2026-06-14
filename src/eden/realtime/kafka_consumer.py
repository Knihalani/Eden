"""Kafka consumer for event sourcing and real-time stream processing.

Phase 5.4: Ingests events from Kafka topics into the Eden data platform.
Supports multiple consumer groups for different processing paths:
- Bronze ingestion (raw events → usage_events table)
- Silver ETL (transformed events → silver_events table)
- ClickHouse analytics (aggregated metrics)
- Alerting (anomaly detection triggers)

Usage:
    from eden.realtime.kafka_consumer import KafkaEventConsumer
    consumer = KafkaEventConsumer(
        bootstrap_servers="localhost:9092",
        group_id="eden-silver-etl",
    )
    await consumer.start()
    await consumer.consume_etl("eden-events")
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


# ─────────────────────────────────────────────────────────────────────────────
# Canonical topic names — single source of truth for all producers/consumers
# ─────────────────────────────────────────────────────────────────────────────
# Phase 5.4: every event type in the platform has a dedicated Kafka topic
# so consumers can subscribe selectively (e.g. the alerts service only
# subscribes to eden-alert, not the entire event firehose).
EDEN_TOPICS = {
    "events": "eden-events",          # Raw events → Bronze ingestion
    "trace": "eden-trace",            # Trace events (env + production spans)
    "benchmark": "eden-benchmark",    # Benchmark run results
    "metering": "eden-metering",      # Per-tenant usage events (high-fanout)
    "alert": "eden-alert",            # Anomaly / threshold alerts
    "silver": "eden-silver",          # Curated silver events
    "analytics": "eden-analytics",    # ClickHouse aggregates
    "dlq": "eden-dlq",                # Dead-letter queue
}


@dataclass
class KafkaMessage:
    """Parsed Kafka message with event data."""

    topic: str
    partition: int
    offset: int
    key: str | None
    value: dict[str, Any]
    timestamp: datetime
    headers: dict[str, str] = field(default_factory=dict)


class KafkaEventConsumer:
    """Kafka consumer for Eden event sourcing.

    Features:
    - Configurable consumer groups for parallel processing
    - Automatic offset management (commit on successful processing)
    - Backpressure handling via asyncio semaphore
    - Graceful shutdown with pending message drain
    - Dead-letter queue for unprocessable messages
    - Health check endpoint for monitoring
    """

    def __init__(
        self,
        bootstrap_servers: str | None = None,
        group_id: str = "eden-consumer",
        auto_offset_reset: str = "earliest",
        max_poll_records: int = 500,
        session_timeout_ms: int = 30000,
        heartbeat_interval_ms: int = 10000,
        max_workers: int = 4,
    ) -> None:
        """Initialize the Kafka consumer.

        Args:
            bootstrap_servers: Kafka broker addresses (comma-separated).
            group_id: Consumer group identifier.
            auto_offset_reset: Where to start if no committed offset exists.
            max_poll_records: Max records per poll batch.
            session_timeout_ms: Consumer session timeout.
            heartbeat_interval_ms: Heartbeat interval.
            max_workers: Max concurrent message processors.
        """
        self.bootstrap_servers = bootstrap_servers or getattr(
            settings, "kafka_bootstrap_servers", "localhost:9092"
        )
        self.group_id = group_id
        self.auto_offset_reset = auto_offset_reset
        self.max_poll_records = max_poll_records
        self.session_timeout_ms = session_timeout_ms
        self.heartbeat_interval_ms = heartbeat_interval_ms
        self.max_workers = max_workers

        self._consumer: Any = None
        self._running = False
        self._semaphore: asyncio.Semaphore | None = None
        self._tasks: set[asyncio.Task] = set()
        self._metrics = {
            "messages_consumed": 0,
            "messages_processed": 0,
            "messages_failed": 0,
            "dlq_messages": 0,
            "last_message_at": None,
        }

    async def _get_consumer(self) -> Any:
        """Lazy-initialize the Kafka consumer."""
        if self._consumer is not None:
            return self._consumer

        try:
            from aiokafka import AIOKafkaConsumer
        except ImportError:
            logger.error(
                "aiokafka not installed. Install with: pip install aiokafka"
            )
            raise

        self._consumer = AIOKafkaConsumer(
            bootstrap_servers=self.bootstrap_servers,
            group_id=self.group_id,
            auto_offset_reset=self.auto_offset_reset,
            max_poll_records=self.max_poll_records,
            session_timeout_ms=self.session_timeout_ms,
            heartbeat_interval_ms=self.heartbeat_interval_ms,
            enable_auto_commit=False,  # Manual commit for reliability
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
            key_deserializer=lambda k: k.decode("utf-8") if k else None,
        )
        await self._consumer.start()
        self._semaphore = asyncio.Semaphore(self.max_workers)
        logger.info(f"Kafka consumer started: group={self.group_id}")
        return self._consumer

    async def start(self) -> None:
        """Start the consumer (pre-connects to Kafka)."""
        if self._running:
            return
        self._running = True
        await self._get_consumer()

    async def stop(self) -> None:
        """Gracefully stop the consumer."""
        self._running = False

        # Wait for pending tasks
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()

        if self._consumer:
            await self._consumer.stop()
            self._consumer = None
            logger.info(f"Kafka consumer stopped: group={self.group_id}")

    async def consume_bronze(
        self,
        topic: str = "eden-events",
    ) -> None:
        """Consume raw events and ingest into Bronze layer (usage_events).

        This is the primary ingestion path for external event producers.
        """
        consumer = await self._get_consumer()
        self._consumer.subscribe([topic])
        logger.info(f"Subscribed to topic: {topic} (Bronze ingestion)")

        from eden.data_platform.bronze_sink import get_bronze_sink

        sink = None
        try:
            sink = await get_bronze_sink()
        except Exception as exc:
            logger.warning(f"Bronze sink unavailable for Kafka consumer: {exc}")

        try:
            async for msg in consumer:
                if not self._running:
                    break

                async with self._semaphore:
                    try:
                        event = KafkaMessage(
                            topic=msg.topic,
                            partition=msg.partition,
                            offset=msg.offset,
                            key=msg.key,
                            value=msg.value,
                            timestamp=datetime.fromtimestamp(
                                msg.timestamp / 1000.0, tz=UTC
                            ) if msg.timestamp else datetime.now(UTC),
                            headers={k: v.decode("utf-8") for k, v in (msg.headers or [])},
                        )

                        if sink:
                            await sink.ingest(event.value)

                        self._metrics["messages_processed"] += 1
                        await consumer.commit()

                    except Exception as exc:
                        logger.error(f"Bronze ingestion failed for offset {msg.offset}: {exc}")
                        self._metrics["messages_failed"] += 1
                        await self._send_to_dlq(msg, str(exc))

                    self._metrics["messages_consumed"] += 1
                    self._metrics["last_message_at"] = datetime.now(UTC).isoformat()

        except Exception as exc:
            logger.error(f"Kafka consumer error: {exc}")
        finally:
            if sink:
                try:
                    from eden.data_platform.bronze_sink import close_bronze_sink
                    await close_bronze_sink()
                except Exception:
                    pass

    async def consume_silver_etl(
        self,
        topic: str = "eden-silver",
    ) -> None:
        """Consume pre-transformed events and ingest into Silver layer.

        Used when an external ETL process produces Silver-ready events.
        """
        consumer = await self._get_consumer()
        self._consumer.subscribe([topic])
        logger.info(f"Subscribed to topic: {topic} (Silver ETL)")

        from eden.data_platform.silver_etl import SilverETLPipeline

        etl = SilverETLPipeline()

        try:
            async for msg in consumer:
                if not self._running:
                    break

                async with self._semaphore:
                    try:
                        events = msg.value if isinstance(msg.value, list) else [msg.value]
                        report = await etl.run_batch(events)
                        logger.info(
                            f"Silver ETL batch: processed={report.processed}, "
                            f"inserted={report.silver_inserted}"
                        )

                        self._metrics["messages_processed"] += 1
                        await consumer.commit()

                    except Exception as exc:
                        logger.error(f"Silver ETL failed for offset {msg.offset}: {exc}")
                        self._metrics["messages_failed"] += 1
                        await self._send_to_dlq(msg, str(exc))

                    self._metrics["messages_consumed"] += 1
                    self._metrics["last_message_at"] = datetime.now(UTC).isoformat()

        except Exception as exc:
            logger.error(f"Kafka Silver ETL consumer error: {exc}")

    async def consume_clickhouse(
        self,
        topic: str = "eden-analytics",
    ) -> None:
        """Consume analytics events and ingest into ClickHouse.

        For high-volume aggregated metrics that bypass PostgreSQL.
        """
        consumer = await self._get_consumer()
        self._consumer.subscribe([topic])
        logger.info(f"Subscribed to topic: {topic} (ClickHouse analytics)")

        from eden.data_platform.clickhouse_sink import get_clickhouse_sink

        sink = None
        try:
            sink = await get_clickhouse_sink()
        except Exception as exc:
            logger.warning(f"ClickHouse sink unavailable: {exc}")

        try:
            async for msg in consumer:
                if not self._running:
                    break

                async with self._semaphore:
                    try:
                        events = msg.value if isinstance(msg.value, list) else [msg.value]

                        # Route to appropriate ClickHouse table based on event_type
                        agent_traces = [e for e in events if "agent" in e.get("event_type", "")]
                        pipeline_stages = [e for e in events if "pipeline" in e.get("event_type", "")]
                        usage_events = [e for e in events if e.get("event_type") in (
                            "llm_call", "job_start", "job_complete", "storage", "sandbox"
                        )]
                        benchmarks = [e for e in events if "benchmark" in e.get("event_type", "")]

                        if sink:
                            if agent_traces:
                                await sink.ingest_agent_traces(agent_traces)
                            if pipeline_stages:
                                await sink.ingest_pipeline_stages(pipeline_stages)
                            if usage_events:
                                await sink.ingest_usage_trends(usage_events)
                            if benchmarks:
                                await sink.ingest_benchmark_results(benchmarks)

                        self._metrics["messages_processed"] += 1
                        await consumer.commit()

                    except Exception as exc:
                        logger.error(f"ClickHouse ingestion failed: {exc}")
                        self._metrics["messages_failed"] += 1
                        await self._send_to_dlq(msg, str(exc))

                    self._metrics["messages_consumed"] += 1
                    self._metrics["last_message_at"] = datetime.now(UTC).isoformat()

        except Exception as exc:
            logger.error(f"Kafka ClickHouse consumer error: {exc}")
        finally:
            if sink:
                try:
                    from eden.data_platform.clickhouse_sink import close_clickhouse_sink
                    await close_clickhouse_sink()
                except Exception:
                    pass

    async def _send_to_dlq(self, msg: Any, error: str) -> None:
        """Send a failed message to the dead-letter queue topic."""
        try:
            from aiokafka import AIOKafkaProducer

            producer = AIOKafkaProducer(
                bootstrap_servers=self.bootstrap_servers,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            )
            await producer.start()

            dlq_message = {
                "original_topic": msg.topic,
                "partition": msg.partition,
                "offset": msg.offset,
                "error": error,
                "timestamp": datetime.now(UTC).isoformat(),
                "value": msg.value,
            }

            await producer.send("eden-dlq", dlq_message)
            await producer.stop()

            self._metrics["dlq_messages"] += 1
            logger.info(f"Message sent to DLQ: {msg.topic}:{msg.partition}:{msg.offset}")
        except Exception as exc:
            logger.error(f"Failed to send message to DLQ: {exc}")

    def get_metrics(self) -> dict[str, Any]:
        """Return consumer metrics for health monitoring."""
        return dict(self._metrics)

    async def health_check(self) -> dict[str, Any]:
        """Check consumer health."""
        try:
            consumer = await self._get_consumer()
            # Try to get assignment to verify connectivity
            assignment = consumer.assignment()
            return {
                "status": "healthy",
                "group_id": self.group_id,
                "topics": list(assignment) if assignment else [],
                "metrics": self.get_metrics(),
            }
        except Exception as exc:
            return {
                "status": "unhealthy",
                "error": str(exc),
                "metrics": self.get_metrics(),
            }


# ── Producer helper for internal event publishing ────────────────────────────

class KafkaEventProducer:
    """Kafka producer for publishing Eden events.

    Used by the API layer to publish events for downstream consumers.
    """

    def __init__(
        self,
        bootstrap_servers: str | None = None,
    ) -> None:
        self.bootstrap_servers = bootstrap_servers or getattr(
            settings, "kafka_bootstrap_servers", "localhost:9092"
        )
        self._producer: Any = None

    async def _get_producer(self) -> Any:
        if self._producer is not None:
            return self._producer

        try:
            from aiokafka import AIOKafkaProducer
        except ImportError:
            logger.error("aiokafka not installed")
            raise

        self._producer = AIOKafkaProducer(
            bootstrap_servers=self.bootstrap_servers,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: k.encode("utf-8") if k else None,
        )
        await self._producer.start()
        return self._producer

    async def send(
        self,
        topic: str,
        event: dict[str, Any],
        key: str | None = None,
    ) -> None:
        """Publish an event to a Kafka topic."""
        producer = await self._get_producer()
        await producer.send(topic, event, key=key)

    async def send_batch(
        self,
        topic: str,
        events: list[dict[str, Any]],
    ) -> None:
        """Publish a batch of events to a Kafka topic."""
        producer = await self._get_producer()
        for event in events:
            await producer.send(topic, event)

    async def close(self) -> None:
        if self._producer:
            await self._producer.stop()
            self._producer = None


# ── Singleton accessors ──────────────────────────────────────────────────

_kafka_consumer: KafkaEventConsumer | None = None
_kafka_producer: KafkaEventProducer | None = None


async def get_kafka_consumer() -> KafkaEventConsumer:
    """Get the singleton Kafka consumer."""
    global _kafka_consumer
    if _kafka_consumer is None:
        _kafka_consumer = KafkaEventConsumer()
        await _kafka_consumer.start()
    return _kafka_consumer


async def close_kafka_consumer() -> None:
    """Close the singleton Kafka consumer."""
    global _kafka_consumer
    if _kafka_consumer:
        await _kafka_consumer.stop()
        _kafka_consumer = None


async def get_kafka_producer() -> KafkaEventProducer:
    """Get the singleton Kafka producer."""
    global _kafka_producer
    if _kafka_producer is None:
        _kafka_producer = KafkaEventProducer()
    return _kafka_producer


async def close_kafka_producer() -> None:
    """Close the singleton Kafka producer."""
    global _kafka_producer
    if _kafka_producer:
        await _kafka_producer.close()
        _kafka_producer = None
